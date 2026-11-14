import { z } from "zod";
import { parseIsoDate } from "./calendar-date";
import { parseMoney } from "./money";

/**
 * Fields shared by the routes' strict request schemas. Money leaves as a
 * canonical decimal string, dates as "YYYY-MM-DD". Pure, so forms can use them.
 */

export function moneyField(allowNegative: boolean) {
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

export const isoDateField = z
  .string()
  .max(10)
  .refine((value) => parseIsoDate(value) !== null, "Not a date");

/** Free text that may be left blank: trimmed, and "" becomes null. */
export function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === "" ? null : value));
}
