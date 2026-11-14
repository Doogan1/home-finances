import { z } from "zod";
import { isTimeZone, parseIsoDate } from "@/lib/calendar-date";
import { parseMoney } from "@/lib/money";

/**
 * Request bodies for the hand-entered account routes. Strict objects: an
 * unexpected field (a household id, say) is a 400, never quietly ignored.
 * Money leaves here as a canonical decimal string; dates as "YYYY-MM-DD".
 */

export const ACCOUNT_KINDS = {
  checking: { type: "depository", subtype: "checking", label: "Checking" },
  savings: { type: "depository", subtype: "savings", label: "Savings" },
  credit_card: { type: "credit", subtype: "credit card", label: "Credit card" },
} as const;
export type AccountKind = keyof typeof ACCOUNT_KINDS;

function money(allowNegative: boolean) {
  return z
    .string()
    .max(32)
    .transform((value, ctx) => {
      const parsed = parseMoney(value, { allowNegative });
      if (parsed === null) {
        ctx.addIssue({ code: "custom", message: "Not an amount" });
        return z.NEVER;
      }
      return parsed;
    });
}

/** "" (a cleared field) becomes null; anything else must be an amount. */
const optionalCushion = z.union([z.literal("").transform(() => null), money(false)]);
const optionalLabel = z
  .string()
  .trim()
  .max(40)
  .transform((value) => (value === "" ? null : value));
const name = z.string().trim().min(1).max(80);

const isoDate = z
  .string()
  .max(10)
  .refine((value) => parseIsoDate(value) !== null, "Not a date");

export const createAccountInput = z
  .strictObject({
    name,
    kind: z.enum(["checking", "savings", "credit_card"]),
    ownerLabel: optionalLabel.optional(),
    cushion: optionalCushion.optional(),
  })
  .transform((input) => ({ ...input, ownerLabel: input.ownerLabel ?? null, cushion: input.cushion ?? null }));
export type CreateAccountInput = z.infer<typeof createAccountInput>;

export const updateAccountInput = z
  .strictObject({
    name: name.optional(),
    ownerLabel: optionalLabel.optional(),
    cushion: optionalCushion.optional(),
    includeInForecast: z.boolean().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, "Nothing to change");
export type UpdateAccountInput = z.infer<typeof updateAccountInput>;

export const recordBalancesInput = z
  .strictObject({
    asOfDate: isoDate,
    note: z.string().trim().max(200).optional(),
    entries: z
      .array(z.strictObject({ accountId: z.uuid(), balance: money(true) }))
      .min(1)
      .max(50),
  })
  .refine((input) => new Set(input.entries.map((e) => e.accountId)).size === input.entries.length, "An account appears twice")
  .transform((input) => ({ ...input, note: input.note ? input.note : null }));
export type RecordBalancesInput = z.infer<typeof recordBalancesInput>;

export const timeZoneInput = z.strictObject({
  timeZone: z.string().max(64).refine(isTimeZone, "Not a time zone"),
});
export type TimeZoneInput = z.infer<typeof timeZoneInput>;
