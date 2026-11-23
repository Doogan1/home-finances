import "server-only";
import { z } from "zod";
import { jsonNoStore } from "@/lib/http";
import { isoDateField } from "@/lib/zod-fields";
import { RULE_MESSAGES } from "./messages";
import { RuleInputError } from "./service";
import type { RuleErrorCode } from "./versions";

const STATUS: Record<RuleErrorCode, number> = {
  rule_not_found: 404,
  version_not_found: 404,
  account_not_found: 404,
  rule_archived: 409,
  account_archived: 409,
  rule_ended: 409,
  account_linked: 400,
  income_to_credit: 400,
  bill_needs_one_account: 400,
  needs_one_remainder: 400,
  over_allocated: 400,
  pays_account_invalid: 400,
  anchor_not_on_day: 400,
  anchor_before_start: 400,
  change_not_after_start: 400,
  no_later_occurrence: 400,
  stop_before_version_start: 400,
  end_before_start: 400,
  only_latest_version_can_end: 400,
  occurrence_not_found: 404,
  confirmed_needs_amount: 400,
  move_out_of_range: 400,
  question_not_found: 409,
};

/** Fixed messages only; internal errors are logged by name, never by content. */
export function ruleErrorResponse(error: unknown, route: string): Response {
  if (error instanceof RuleInputError) {
    return jsonNoStore({ error: error.code, message: RULE_MESSAGES[error.code] }, STATUS[error.code]);
  }
  console.error(`[rules] ${route} failed unexpectedly`, { name: error instanceof Error ? error.name : typeof error });
  return jsonNoStore({ error: "internal_error", message: "Something went wrong." }, 500);
}

export const ruleNotFound = () => ruleErrorResponse(new RuleInputError("rule_not_found"), "lookup");
export const versionNotFound = () => ruleErrorResponse(new RuleInputError("version_not_found"), "lookup");

export type OccurrenceContext = { params: Promise<{ id: string; date: string }> };

/** The rule and scheduled date named in an occurrence route's address, or the 404 to answer with. */
export async function occurrenceTarget(context: OccurrenceContext): Promise<{ ruleId: string; scheduledOn: string } | Response> {
  const { id, date } = await context.params;
  if (!z.uuid().safeParse(id).success) return ruleNotFound();
  if (!isoDateField.safeParse(date).success) return ruleErrorResponse(new RuleInputError("occurrence_not_found"), "lookup");
  return { ruleId: id, scheduledOn: date };
}
