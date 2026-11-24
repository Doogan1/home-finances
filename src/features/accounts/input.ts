import { z } from "zod";
import { isTimeZone } from "@/lib/calendar-date";
import { isoDateField, moneyField, optionalText } from "@/lib/zod-fields";

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

/** "" (a cleared field) becomes null; anything else must be an amount. */
const optionalCushion = z.union([z.literal("").transform(() => null), moneyField(false)]);
const name = z.string().trim().min(1).max(80);

export const createAccountInput = z
  .strictObject({
    name,
    kind: z.enum(["checking", "savings", "credit_card"]),
    ownerLabel: optionalText(40).optional(),
    cushion: optionalCushion.optional(),
  })
  .transform((input) => ({ ...input, ownerLabel: input.ownerLabel ?? null, cushion: input.cushion ?? null }));
export type CreateAccountInput = z.infer<typeof createAccountInput>;

export const updateAccountInput = z
  .strictObject({
    name: name.optional(),
    ownerLabel: optionalText(40).optional(),
    cushion: optionalCushion.optional(),
    includeInForecast: z.boolean().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, "Nothing to change");
export type UpdateAccountInput = z.infer<typeof updateAccountInput>;

export const recordBalancesInput = z
  .strictObject({
    asOfDate: isoDateField,
    note: z.string().trim().max(200).optional(),
    entries: z
      .array(z.strictObject({ accountId: z.uuid(), balance: moneyField(true) }))
      .min(1)
      .max(40),
  })
  .refine((input) => new Set(input.entries.map((e) => e.accountId)).size === input.entries.length, "An account appears twice")
  .transform((input) => ({ ...input, note: input.note ? input.note : null }));
export type RecordBalancesInput = z.infer<typeof recordBalancesInput>;

export const timeZoneInput = z.strictObject({
  timeZone: z.string().max(64).refine(isTimeZone, "Not a time zone"),
});
export type TimeZoneInput = z.infer<typeof timeZoneInput>;

/** Attach: the bank account to attach to the hand-entered account in the URL. */
export const attachAccountInput = z.strictObject({ plaidAccountId: z.uuid() });
export type AttachAccountInput = z.infer<typeof attachAccountInput>;
