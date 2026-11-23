import { MAX_MOVE_DAYS, type RuleErrorCode } from "./versions";

/** What the person is told for each refusal. Routes and form previews share these. */
export const RULE_MESSAGES: Record<RuleErrorCode, string> = {
  rule_not_found: "That bill or income was not found.",
  version_not_found: "That version was not found.",
  rule_archived: "This is archived, so it can't be changed.",
  account_not_found: "One of those accounts was not found.",
  account_archived: "One of those accounts is archived.",
  account_linked: "Bills and income use accounts entered by hand for now, not ones from a connected bank.",
  income_to_credit: "Income can't go to a credit card account.",
  bill_needs_one_account: "A bill is paid from exactly one account.",
  needs_one_remainder: "Exactly one account must take the rest.",
  over_allocated: "The splits add up to more than the amount.",
  pays_account_invalid: "The card a bill pays must be one of your credit card accounts, entered by hand.",
  anchor_not_on_day: "For a monthly schedule, the first date must fall on its day of the month.",
  anchor_before_start: "The first date can't be before the version starts.",
  change_not_after_start: "A change must start after the latest version does. To fix that version itself, use Edit this version.",
  rule_ended: "This has already stopped by then. Edit its last version to change the stop date.",
  no_later_occurrence: "The current schedule has no date on or after that day. Change the schedule too.",
  stop_before_version_start: "That's before the latest change starts. Pick a later date, or edit that change.",
  end_before_start: "The end date can't be before the version starts.",
  only_latest_version_can_end: "Only the latest version's end date can be changed.",
  occurrence_not_found: "This bill or income has no date then. It may have changed since this page was opened.",
  confirmed_needs_amount: "Enter the confirmed amount, or choose another status.",
  move_out_of_range: `An occurrence can be moved up to ${MAX_MOVE_DAYS} days either way.`,
  question_not_found: "That question has already been answered or no longer applies. Reload to see what's left.",
};
