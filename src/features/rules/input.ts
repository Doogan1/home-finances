import { z } from "zod";
import { toCents } from "@/lib/cents";
import { isoDateField, moneyField, optionalText } from "@/lib/zod-fields";
import type { Pattern } from "./recurrence";
import type { AllocationLike } from "./splits";
import type { ChangeFrom, VersionEdit } from "./versions";

/**
 * Request bodies for the rule routes. Strict objects: an unexpected field (a
 * household id, say) is a 400, never quietly ignored. Limits the database also
 * enforces are checked here first so the person gets a clear refusal.
 */

export type ScheduleBody =
  | { recurrence: "ONCE"; anchorDate: string }
  | { recurrence: "WEEKLY"; interval: number; anchorDate: string }
  | { recurrence: "MONTHLY"; interval: number; anchorDate: string; dayOfMonth: number }
  | { recurrence: "TWICE_MONTHLY"; anchorDate: string; dayOfMonth: number; secondDay: number };

export function toPattern(body: ScheduleBody): Pattern {
  return {
    recurrence: body.recurrence,
    interval: "interval" in body ? body.interval : 1,
    anchorDate: body.anchorDate,
    dayOfMonth: "dayOfMonth" in body ? body.dayOfMonth : null,
    secondDay: "secondDay" in body ? body.secondDay : null,
  };
}

const positiveMoney = moneyField(false).refine((value) => value !== "0", "Must be more than zero");

const PERCENT = /^\d{1,3}(\.\d{1,2})?$/;
const percent = z
  .string()
  .trim()
  .max(8)
  .refine((value) => PERCENT.test(value) && toCents(value) > 0n && toCents(value) <= 10000n, "A percentage above 0, up to 100");

export const scheduleInput = z
  .discriminatedUnion("recurrence", [
    z.strictObject({ recurrence: z.literal("ONCE"), anchorDate: isoDateField }),
    z.strictObject({ recurrence: z.literal("WEEKLY"), interval: z.int().min(1).max(52), anchorDate: isoDateField }),
    z.strictObject({
      recurrence: z.literal("MONTHLY"),
      interval: z.int().min(1).max(24),
      anchorDate: isoDateField,
      dayOfMonth: z.int().min(1).max(31),
    }),
    z.strictObject({
      recurrence: z.literal("TWICE_MONTHLY"),
      anchorDate: isoDateField,
      dayOfMonth: z.int().min(1).max(27),
      secondDay: z.int().min(2).max(31),
    }),
  ])
  .refine((s) => s.recurrence !== "TWICE_MONTHLY" || s.secondDay > s.dayOfMonth, "The second day must come after the first")
  .transform(toPattern);

const allocationInput = z
  .discriminatedUnion("mode", [
    z.strictObject({ accountId: z.uuid(), mode: z.literal("PERCENT"), value: percent }),
    z.strictObject({ accountId: z.uuid(), mode: z.literal("FIXED"), value: positiveMoney }),
    z.strictObject({ accountId: z.uuid(), mode: z.literal("REMAINDER") }),
  ])
  .transform((a): AllocationLike => ({ accountId: a.accountId, mode: a.mode, value: "value" in a ? a.value : null }));

const allocationsInput = z
  .array(allocationInput)
  .min(1)
  .max(10)
  .refine((list) => new Set(list.map((a) => a.accountId)).size === list.length, "An account appears twice");

const versionFields = {
  amount: positiveMoney,
  schedule: scheduleInput,
  allocations: allocationsInput,
  note: optionalText(200).optional(),
};
const ruleName = z.string().trim().min(1).max(80);

export const createRuleInput = z
  .strictObject({
    kind: z.enum(["INCOME", "BILL"]),
    name: ruleName,
    category: optionalText(40).optional(),
    notes: optionalText(500).optional(),
    paysAccountId: z.uuid().nullable().optional(),
    effectiveFrom: isoDateField.optional(),
    ...versionFields,
  })
  .transform((input) => ({
    kind: input.kind,
    name: input.name,
    category: input.category ?? null,
    notes: input.notes ?? null,
    paysAccountId: input.paysAccountId ?? null,
    version: {
      ...input.schedule,
      effectiveFrom: input.effectiveFrom ?? input.schedule.anchorDate,
      amount: input.amount,
      note: input.note ?? null,
      allocations: input.allocations,
    },
  }));
export type CreateRuleInput = z.infer<typeof createRuleInput>;

export const updateRuleInput = z
  .strictObject({
    name: ruleName.optional(),
    category: optionalText(40).optional(),
    notes: optionalText(500).optional(),
    paysAccountId: z.uuid().nullable().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, "Nothing to change");
export type UpdateRuleInput = z.infer<typeof updateRuleInput>;

export const changeFromInput = z
  .strictObject({
    from: isoDateField,
    amount: positiveMoney,
    allocations: allocationsInput,
    note: optionalText(200).optional(),
    schedule: scheduleInput.optional(),
  })
  .transform(
    (input): ChangeFrom => ({
      from: input.from,
      amount: input.amount,
      note: input.note ?? null,
      allocations: input.allocations,
      schedule: input.schedule ?? null,
    }),
  );
export type ChangeFromInput = z.infer<typeof changeFromInput>;

export const stopInput = z.strictObject({ on: isoDateField });
export type StopInput = z.infer<typeof stopInput>;

export const editVersionInput = z
  .strictObject({ ...versionFields, effectiveTo: isoDateField.nullable().optional() })
  .transform(
    (input): VersionEdit => ({
      ...input.schedule,
      amount: input.amount,
      note: input.note ?? null,
      allocations: input.allocations,
      effectiveTo: input.effectiveTo,
    }),
  );
export type EditVersionInput = z.infer<typeof editVersionInput>;

export const archiveRuleInput = z.strictObject({});
